import { ethers, deployments } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  LockingInfoContractName,
  LockingPoolContractName,
  l2MetisAddr,
} from "../utils/constant";
import { trimPubKeyPrefix } from "../utils/params";

describe("locking", async () => {
  async function fixture() {
    const wallets = new Array(5)
      .fill(null)
      .map(() => ethers.Wallet.createRandom(ethers.provider));

    const [admin, mpc, ...others] = await ethers.getSigners();

    // deploy test bridge
    const TestBridge = await ethers.getContractFactory("TestBridge");
    const l1Bridge = await TestBridge.deploy();

    // deploy test ERC20
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const metisToken = await TestERC20.deploy(ethers.parseEther("1000000"));

    const lockingEscrowProxy = await deployments.deploy(
      LockingInfoContractName,
      {
        from: admin.address,
        proxy: {
          proxyContract: "OpenZeppelinTransparentProxy",
          execute: {
            init: {
              methodName: "initialize",
              args: [
                await l1Bridge.getAddress(),
                await metisToken.getAddress(),
                l2MetisAddr,
                0xdeadbeaf,
              ],
            },
          },
        },
      },
    );

    const lockingInfo = await ethers.getContractAt(
      LockingInfoContractName,
      lockingEscrowProxy.address,
    );

    const lockingManagerProxy = await deployments.deploy(
      LockingPoolContractName,
      {
        from: admin.address,
        proxy: {
          proxyContract: "OpenZeppelinTransparentProxy",
          execute: {
            init: {
              methodName: "initialize",
              args: [lockingEscrowProxy.address],
            },
          },
        },
      },
    );

    const lockingPool = await ethers.getContractAt(
      LockingPoolContractName,
      lockingManagerProxy.address,
    );
    await lockingInfo.initManager(lockingManagerProxy.address);

    // approve the metis to the lockingManager
    for (const [index, wallet] of wallets.entries()) {
      await admin.sendTransaction({
        to: wallet.address,
        value: ethers.parseEther("10"),
      });
      await metisToken.mint(wallet, ethers.parseEther("20000"));
      await metisToken
        .connect(wallet)
        .approve(lockingEscrowProxy.address, ethers.MaxUint256);

      // first 3 addresses are whitelisted
      if (index < 3) {
        await lockingPool.setWhitelist(wallet.address, true);
      }
    }

    return {
      wallets,
      lockingInfo,
      lockingPool,
      metisToken,
      l1Bridge,
      admin,
      mpc,
      others,
    };
  }

  it("default", async () => {
    const { l1Bridge, metisToken, lockingInfo, lockingPool, admin } =
      await loadFixture(fixture);
    expect(await lockingInfo.bridge(), "bridge").to.be.eq(
      await l1Bridge.getAddress(),
    );
    expect(await lockingInfo.l1Token(), "l1token").to.be.eq(
      await metisToken.getAddress(),
    );
    expect(await lockingInfo.l2Token(), "l2token").to.be.eq(l2MetisAddr);
    expect(await lockingInfo.l2ChainId(), "l2ChainId").to.be.eq(0xdeadbeaf);
    expect(await lockingInfo.owner(), "owner").to.be.eq(admin, "admin address");

    expect(await lockingInfo.minLock(), "minLock").to.eq(
      ethers.parseEther("20000"),
    );
    expect(await lockingInfo.maxLock(), "maxLocak").to.eq(
      ethers.parseEther("100000"),
    );

    expect(await lockingInfo.rewardPayer()).eq(ethers.ZeroAddress);
    expect(await lockingInfo.manager(), "default manager").eq(
      await lockingPool.getAddress(),
    );
  });

  it("setMinLock", async () => {
    const { lockingInfo, others } = await loadFixture(fixture);

    const newLimit = 10;

    await expect(
      lockingInfo.connect(others[0]).setMinLock(newLimit),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(lockingInfo.setMinLock(0)).to.be.revertedWith("_minLock=0");

    expect(await lockingInfo.setMinLock(newLimit))
      .to.emit(lockingInfo, "SetMinLock")
      .withArgs(newLimit);
    expect(await lockingInfo.minLock()).to.eq(newLimit);
  });

  it("setMaxLock", async () => {
    const { lockingInfo, others } = await loadFixture(fixture);

    const newMin = 10;
    const newMax = 100;

    await lockingInfo.setMinLock(newMin);

    await expect(
      lockingInfo.connect(others[0]).setMaxLock(newMax),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(lockingInfo.setMaxLock(9)).to.be.revertedWith(
      "maxLock<minLock",
    );

    expect(await lockingInfo.setMaxLock(newMax))
      .to.emit(lockingInfo, "SetMaxLock")
      .withArgs(newMax);
    expect(await lockingInfo.maxLock(), "maxLock").to.eq(newMax);
  });

  it("updateWithdrawDelayTimeValue", async () => {
    const { lockingPool, mpc, others, lockingInfo } =
      await loadFixture(fixture);

    const curDelayTime = await lockingPool.WITHDRAWAL_DELAY();
    expect(curDelayTime, "default delay time").to.be.eq(21 * 24 * 3600);

    const newDelayTime = 24 * 3600 * 1000;

    await expect(
      lockingPool.connect(mpc).updateWithdrawDelayTimeValue(newDelayTime),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      lockingPool.connect(others[0]).updateWithdrawDelayTimeValue(newDelayTime),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      lockingPool.updateWithdrawDelayTimeValue(0),
    ).to.be.revertedWith("dalayTime==0");

    expect(await lockingPool.updateWithdrawDelayTimeValue(newDelayTime))
      .to.emit(lockingInfo, "WithrawDelayTimeChange")
      .withArgs(newDelayTime, curDelayTime);
    expect(await lockingPool.WITHDRAWAL_DELAY()).to.eq(newDelayTime);
  });

  it("updateBlockReward", async () => {
    const { lockingPool, mpc, others, lockingInfo } =
      await loadFixture(fixture);

    const defaultRpb = await lockingPool.BLOCK_REWARD();
    expect(defaultRpb, "default reward_per_block").eq(761000n * 10n ** 9n);

    const newRpb = 10n;

    await expect(
      lockingPool.connect(mpc).updateBlockReward(newRpb),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      lockingPool.connect(others[0]).updateBlockReward(newRpb),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(lockingPool.updateBlockReward(0)).to.be.revertedWith(
      "invalid newReward",
    );

    expect(await lockingPool.updateBlockReward(newRpb))
      .to.emit(lockingInfo, "RewardUpdate")
      .withArgs(newRpb, defaultRpb);
    expect(await lockingPool.BLOCK_REWARD()).to.be.eq(
      newRpb,
      "newReward check",
    );
  });

  it("updateMpc", async () => {
    const { lockingPool, mpc, others } = await loadFixture(fixture);

    expect(await lockingPool.mpcAddress(), "default mpc").to.eq(
      ethers.ZeroAddress,
    );

    await expect(
      lockingPool.connect(mpc).updateMpc(others[0]),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      lockingPool.connect(others[0]).updateMpc(others[0]),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    expect(await lockingPool.updateMpc(others[0]))
      .to.emit(lockingPool, "UpdateMpc")
      .withArgs(others[0]);

    expect(await lockingPool.mpcAddress()).to.eq(others[0]);
  });

  it("lockFor/validation", async () => {
    const { lockingInfo, lockingPool, wallets } = await loadFixture(fixture);

    const [wallet0, wallet1, wallet2, wallet3] = wallets;
    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);
    const maxLock = 10n;
    await lockingInfo.setMaxLock(maxLock);

    await lockingPool.setPause(true);
    await expect(
      lockingPool
        .connect(wallet0)
        .lockFor(
          wallet0,
          minLock,
          trimPubKeyPrefix(wallet0.signingKey.publicKey),
        ),
    ).to.be.revertedWith("Pausable: paused");
    await lockingPool.setPause(false);

    await expect(
      lockingPool
        .connect(wallet3)
        .lockFor(
          wallet3,
          minLock,
          trimPubKeyPrefix(wallet3.signingKey.publicKey),
        ),
    ).to.be.revertedWithCustomError(lockingPool, "NotWhitelisted");

    await expect(
      lockingPool
        .connect(wallet0)
        .lockFor(wallet0, 0, trimPubKeyPrefix(wallet0.signingKey.publicKey)),
    ).to.be.revertedWith("invalid amount");

    await expect(
      lockingPool
        .connect(wallet0)
        .lockFor(
          wallet0,
          maxLock + 1n,
          trimPubKeyPrefix(wallet0.signingKey.publicKey),
        ),
    ).to.be.revertedWith("invalid amount");

    await expect(
      lockingPool
        .connect(wallet0)
        .lockFor(wallet0, minLock, Buffer.from([1, 2, 3])),
    ).to.be.revertedWith("invalid pubkey");

    await expect(
      lockingPool.connect(wallet0).lockFor(
        wallet0,

        minLock,
        trimPubKeyPrefix(wallet1.signingKey.publicKey),
      ),
    ).to.be.revertedWith("pubkey and address mismatch");
  });

  it("lockFor", async () => {
    const { lockingInfo, lockingPool, metisToken, wallets } =
      await loadFixture(fixture);

    const [wallet0, wallet1, wallet2] = wallets;
    const toLock = 1n;
    await lockingInfo.setMinLock(toLock);

    // const wallet0Pubkey = trimPubKeyPrefix(wallet0.signingKey.publicKey);
    const wallet1Pubkey = trimPubKeyPrefix(wallet1.signingKey.publicKey);

    expect(
      await lockingPool
        .connect(wallet0)
        .lockFor(wallet1, toLock, wallet1Pubkey),
      "lockFor owner=wallet0 signer=wallet1",
    )
      .emit(lockingPool, "SequencerOwnerChanged")
      .withArgs(1, wallet0.address)
      .and.emit(lockingPool, "SequencerRewardRecipientChanged")
      .withArgs(1, ethers.ZeroAddress)
      .and.emit(lockingInfo, "Locked")
      .withArgs(wallet1.address, 1, 1, 1, toLock, toLock, wallet1Pubkey)
      .and.emit(metisToken, "Transfer")
      .withArgs(wallet0.address, await lockingInfo.getAddress(), toLock);

    await expect(
      lockingPool.connect(wallet0).lockFor(wallet1, toLock, wallet1Pubkey),
      "OwnedSequencer",
    ).revertedWithCustomError(lockingPool, "OwnedSequencer");

    await expect(
      lockingPool.connect(wallet2).lockFor(wallet1, toLock, wallet1Pubkey),
      "OwnedSigner",
    ).revertedWithCustomError(lockingPool, "OwnedSigner");

    {
      const curBatchId = await lockingPool.currentBatch();
      const {
        amount,
        reward,
        activationBatch,
        updatedBatch,
        deactivationBatch,
        deactivationTime,
        unlockClaimTime,
        nonce,
        owner,
        signer,
        pubkey,
        rewardRecipient,
        status,
      } = await lockingPool.sequencers(1);
      expect(amount, "amount").eq(toLock);
      expect(reward, "reward").eq(0);
      expect(activationBatch, "activationBatch").eq(curBatchId);
      expect(updatedBatch, "updatedBatch").eq(curBatchId);
      expect(deactivationBatch, "deactivationBatch").eq(0);
      expect(deactivationTime, "deactivationTime").eq(0);
      expect(nonce, "deactivationBatch").eq(1);
      expect(owner, "owner").eq(wallet0.address);
      expect(signer, "wallet0").eq(wallet1.address);
      expect(unlockClaimTime, "unlockClaimTime").eq(0);
      expect(pubkey, "pubkey").eq("0x" + wallet1Pubkey.toString("hex"));
      expect(rewardRecipient, "rewardRecipient").eq(ethers.ZeroAddress);
      expect(status, "status").eq(2);
    }

    expect(
      await lockingPool.totalSequencers(),
      "current total sequencer should be 1",
    ).to.eq(1);
    expect(
      await lockingPool.seqOwners(wallet0.address),
      "the address should own the token 1",
    ).to.eq(1);
    expect(
      await lockingPool.seqSigners(wallet1.address),
      "the address should own the token 1",
    ).to.eq(1);
    expect(
      await metisToken.balanceOf(await lockingInfo.getAddress()),
      "balance of Metis should be equal to the locked in",
    ).to.be.eq(toLock);

    expect(await lockingPool.seqStatuses(2), "Active count").to.eq(1);
    expect(await lockingInfo.totalLocked(), "total locked").to.eq(toLock);
  });

  it("lockWithRewardRecipient", async () => {
    const { lockingInfo, lockingPool, metisToken, wallets } =
      await loadFixture(fixture);

    const [wallet0, wallet1] = wallets;
    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);

    const curBatchId = await lockingPool.currentBatch();

    const wallet1Pubkey = trimPubKeyPrefix(wallet1.signingKey.publicKey);

    await expect(
      lockingPool
        .connect(wallet0)
        .lockWithRewardRecipient(wallet1, wallet0, minLock, wallet1Pubkey),
      "lockFor owner=wallet0 signer=wallet1 recipent=wallet0",
    )
      .emit(lockingPool, "SequencerOwnerChanged")
      .withArgs(1, wallet0.address)
      .and.emit(lockingPool, "SequencerRewardRecipientChanged")
      .withArgs(1, wallet0.address)
      .and.emit(lockingInfo, "Locked")
      .withArgs(wallet1.address, 1, 1, 1, minLock, minLock, wallet1Pubkey)
      .and.emit(metisToken, "Transfer")
      .withArgs(wallet0.address, await lockingInfo.getAddress(), minLock);

    {
      const {
        amount,
        reward,
        activationBatch,
        updatedBatch,
        deactivationBatch,
        deactivationTime,
        unlockClaimTime,
        nonce,
        owner,
        signer,
        pubkey,
        rewardRecipient,
        status,
      } = await lockingPool.sequencers(1);
      expect(amount, "amount").eq(minLock);
      expect(reward, "reward").eq(0);
      expect(activationBatch, "activationBatch").eq(curBatchId);
      expect(updatedBatch, "updatedBatch").eq(curBatchId);
      expect(deactivationBatch, "deactivationBatch").eq(0);
      expect(deactivationTime, "deactivationTime").eq(0);
      expect(nonce, "deactivationBatch").eq(1);
      expect(owner, "owner").eq(wallet0.address);
      expect(signer, "wallet0").eq(wallet1.address);
      expect(unlockClaimTime, "unlockClaimTime").eq(0);
      expect(pubkey, "pubkey").eq("0x" + wallet1Pubkey.toString("hex"));
      expect(rewardRecipient, "rewardRecipient").eq(wallet0.address);
      expect(status, "status").eq(2);
    }

    expect(
      await lockingPool.totalSequencers(),
      "current total sequencer should be 1",
    ).to.eq(1);
    expect(
      await lockingPool.seqOwners(wallet0.address),
      "the address should own the token 1",
    ).to.eq(1);
    expect(
      await lockingPool.seqSigners(wallet1.address),
      "the address should own the token 1",
    ).to.eq(1);
    expect(
      await metisToken.balanceOf(await lockingInfo.getAddress()),
      "balance of Metis should be equal to the locked in",
    ).to.be.eq(minLock);

    expect(await lockingPool.seqStatuses(2), "Active count").to.eq(1);
  });

  it("updateSigner", async () => {
    const { lockingInfo, lockingPool, wallets } = await loadFixture(fixture);

    const [wallet0, wallet1, wallet2] = wallets;
    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);

    expect(
      await lockingPool.signerUpdateThrottle(),
      "default signerUpdateThrottle",
    ).to.be.eq(1);

    const wallet0Pubkey = trimPubKeyPrefix(wallet0.signingKey.publicKey);
    const wallet1Pubkey = trimPubKeyPrefix(wallet1.signingKey.publicKey);
    const wallet2Pubkey = trimPubKeyPrefix(wallet2.signingKey.publicKey);

    // seq1
    await lockingPool.connect(wallet0).lockFor(wallet0, minLock, wallet0Pubkey);

    await expect(
      lockingPool.connect(wallet0).updateSigner(1, wallet1Pubkey),
      "update seq1 pubkey from 0",
    ).revertedWith("signer updating throttle");

    await expect(
      lockingPool.connect(wallet1).updateSigner(1, wallet1Pubkey),
      "update seq1 pubkey from wallet1",
    ).revertedWithCustomError(lockingPool, "NotSeqSigner");

    expect(
      await lockingPool.setSignerUpdateThrottle(0),
      "setSignerUpdateThrottle",
    )
      .emit(lockingPool, "SetSignerUpdateThrottle")
      .withArgs(0);

    const curBatchId = await lockingPool.currentBatch();

    await expect(
      lockingPool.connect(wallet0).updateSigner(1, wallet2Pubkey),
      "update seq1 signer key to wallet2",
    )
      .to.emit(lockingInfo, "SignerChange")
      .withArgs(1, 2, wallet0.address, wallet2.address, wallet2Pubkey);

    const { nonce, signer, pubkey, updatedBatch } =
      await lockingPool.sequencers(1);
    expect(nonce, "nonce").eq(2);
    expect(updatedBatch, "updatedBatch").eq(curBatchId);
    expect(signer, "signer").eq(wallet2.address);
    expect(pubkey, "pubkey").eq("0x" + wallet2Pubkey.toString("hex"));

    expect(
      await lockingPool.seqSigners(wallet0.address),
      "wallet0 signer id to uint256",
    ).eq(ethers.MaxUint256);

    expect(await lockingPool.seqSigners(wallet2.address), "wallet2 signer").eq(
      1,
    );
  });

  it("relock/withoutReward", async () => {
    const { lockingInfo, lockingPool, wallets } = await loadFixture(fixture);

    const [wallet0, wallet1, _, wallet3] = wallets;
    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);

    // seq1
    const wallet0Pubkey = trimPubKeyPrefix(wallet0.signingKey.publicKey);
    await lockingPool.connect(wallet0).lockFor(wallet0, minLock, wallet0Pubkey);

    await expect(
      lockingPool.connect(wallet3).relock(1, 1n, false),
      "NotWhitelisted",
    ).to.be.revertedWithCustomError(lockingPool, "NotWhitelisted");

    await expect(
      lockingPool.connect(wallet1).relock(2, 1n, false),
      "SeqNotActive",
    ).to.be.revertedWithCustomError(lockingPool, "SeqNotActive");

    await expect(
      lockingPool.connect(wallet1).relock(1, 1n, false),
      "NotSeqOwner",
    ).to.be.revertedWithCustomError(lockingPool, "NotSeqOwner");

    await lockingInfo.setMaxLock(10);
    await expect(
      lockingPool.connect(wallet0).relock(1, 100n, false),
      "macLock excceed",
    ).to.be.revertedWith("locked>maxLock");

    await expect(
      lockingPool.connect(wallet0).relock(1, 0, false),
      "0 locking",
    ).to.be.revertedWith("No new locked added");

    const relock = 3n;

    await expect(
      lockingPool.connect(wallet0).relock(1, relock, false),
      "relock +3",
    )
      .to.be.emit(lockingInfo, "Relocked")
      .withArgs(1, 3, 4)
      .and.to.be.emit(lockingInfo, "LockUpdate")
      .withArgs(1, 2, 4);

    const { nonce: newNonce, amount: newAmount } =
      await lockingPool.sequencers(1);
    expect(newNonce, "newNonce").to.be.eq(2);
    expect(newAmount, "newAmount").to.be.eq(minLock + relock);
  });

  it("relock/withReward", async () => {
    const { admin, lockingInfo, lockingPool, wallets, metisToken, mpc } =
      await loadFixture(fixture);

    const [wallet0, wallet1] = wallets;
    const firstLocked = 1n;
    await lockingInfo.setMinLock(firstLocked);
    await lockingPool.updateMpc(mpc);
    await lockingInfo.setRewardPayer(admin);
    await metisToken.approve(await lockingInfo.getAddress(), ethers.MaxUint256);

    // seq1
    await lockingPool
      .connect(wallet0)
      .lockFor(
        wallet0,
        firstLocked,
        trimPubKeyPrefix(wallet0.signingKey.publicKey),
      );

    await lockingPool
      .connect(wallet1)
      .lockFor(
        wallet1,
        firstLocked,
        trimPubKeyPrefix(wallet1.signingKey.publicKey),
      );

    const [{ id: curBatchId, endEpoch: lastEndEpoch }, rpb] = await Promise.all(
      [lockingPool.curBatchState(), lockingPool.BLOCK_REWARD()],
    );

    const [newStartEpoch, newEndEpoch, newBatchId, seqs, blocks] = [
      lastEndEpoch + 1n,
      lastEndEpoch + 2n,
      curBatchId + 1n,
      [wallet0, wallet1],
      [2n, 10n],
    ];

    // distribute reward
    await lockingPool
      .connect(mpc)
      .batchSubmitRewards(newBatchId, newStartEpoch, newEndEpoch, seqs, blocks);

    const relock = 3n;
    await expect(
      lockingPool.connect(wallet0).relock(1, relock, true),
      "relock +3",
    )
      .to.be.emit(lockingInfo, "Relocked")
      .withArgs(
        1,
        relock + rpb * blocks[0],
        firstLocked * BigInt(seqs.length) + relock + rpb * blocks[0],
      )
      .and.to.be.emit(lockingInfo, "LockUpdate")
      .withArgs(1, 2, firstLocked + relock + rpb * blocks[0]);

    // wallet 0
    {
      const {
        nonce: newNonce,
        amount: newAmount,
        reward: newUnclaimed,
      } = await lockingPool.sequencers(1);
      expect(newNonce, "wallet0/newNonce").to.be.eq(2);
      expect(newUnclaimed, "wallet0/newReward").to.be.eq(0);
      expect(newAmount, "wallet0/newAmount").to.be.eq(
        firstLocked + relock + rpb * blocks[0],
      );
    }

    // wallet 1
    {
      const { amount: newAmount, reward: newUnclaimed } =
        await lockingPool.sequencers(2);
      expect(newAmount, "wallet1/newAmount").to.be.eq(firstLocked);
      expect(newUnclaimed, "wallet1/newReward").to.be.eq(rpb * blocks[1]);
    }
  });

  it("batchSubmitRewards/validation", async () => {
    const { lockingInfo, lockingPool, mpc, wallets } =
      await loadFixture(fixture);

    const [wallet0, wallet1, _, wallet3] = wallets;
    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);
    await lockingPool.updateMpc(mpc);

    // seq1
    const wallet0Pubkey = trimPubKeyPrefix(wallet0.signingKey.publicKey);
    await lockingPool.connect(wallet0).lockFor(wallet0, minLock, wallet0Pubkey);

    const {
      id: curBatchId,
      startEpoch: lastStartEpoch,
      endEpoch: lastEndEpoch,
    } = await lockingPool.curBatchState();

    const newBatchId = curBatchId + 1n;

    await expect(
      lockingPool.batchSubmitRewards(
        newBatchId,
        lastEndEpoch + 1n,
        lastEndEpoch + 10n,
        [],
        [],
      ),
      "not MPC",
    ).to.revertedWith("not MPC");

    await expect(
      lockingPool
        .connect(mpc)
        .batchSubmitRewards(
          newBatchId,
          lastEndEpoch + 1n,
          lastEndEpoch + 10n,
          [],
          [],
        ),
      "mismatch length",
    ).to.revertedWith("mismatch length");

    await expect(
      lockingPool
        .connect(mpc)
        .batchSubmitRewards(
          curBatchId,
          lastEndEpoch + 1n,
          lastEndEpoch + 10n,
          [wallet0],
          [10],
        ),
      "mismatch length",
    ).to.revertedWith("invalid batch id");

    await expect(
      lockingPool
        .connect(mpc)
        .batchSubmitRewards(
          curBatchId + 1n,
          lastEndEpoch,
          lastEndEpoch,
          [wallet0],
          [10],
        ),
      "invalid endEpoch",
    ).to.revertedWith("invalid startEpoch");

    await expect(
      lockingPool
        .connect(mpc)
        .batchSubmitRewards(
          curBatchId + 1n,
          lastEndEpoch + 1n,
          lastEndEpoch,
          [wallet0],
          [10],
        ),
      "invalid endEpoch",
    ).to.revertedWith("invalid endEpoch");

    await expect(
      lockingPool
        .connect(mpc)
        .batchSubmitRewards(
          curBatchId + 1n,
          lastEndEpoch + 1n,
          lastEndEpoch + 9n,
          [wallet1],
          [10],
        ),
      "NoSuchSeq",
    ).to.revertedWithCustomError(lockingPool, "NoSuchSeq");
  });

  it("batchSubmitRewards", async () => {
    const { lockingInfo, lockingPool, mpc, metisToken, wallets, admin } =
      await loadFixture(fixture);

    const [wallet0] = wallets;
    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);
    await lockingPool.updateMpc(mpc);

    await lockingInfo.setRewardPayer(admin);
    await metisToken.approve(await lockingInfo.getAddress(), ethers.MaxUint256);

    // seq1
    const wallet0Pubkey = trimPubKeyPrefix(wallet0.signingKey.publicKey);
    await lockingPool.connect(wallet0).lockFor(wallet0, minLock, wallet0Pubkey);

    const { id: curBatchId, endEpoch: lastEndEpoch } =
      await lockingPool.curBatchState();

    const balance1 = await metisToken.balanceOf(await lockingInfo.getAddress());

    const newBatchId = curBatchId + 1n;
    const newStartEpoch = lastEndEpoch + 1n;
    const newEndEpoch = newStartEpoch + 9n;

    const seqs = [wallet0];
    const blocks = [10n];

    const rpb = await lockingPool.BLOCK_REWARD();
    const rewards = blocks.reduce((prev, cur) => prev + cur * rpb, 0n);

    const blockNumber = await admin.provider.getBlockNumber();

    await expect(
      lockingPool
        .connect(mpc)
        .batchSubmitRewards(
          newBatchId,
          newStartEpoch,
          newEndEpoch,
          seqs,
          blocks,
        ),
      "Reward",
    )
      .to.emit(lockingInfo, "BatchSubmitReward")
      .withArgs(newBatchId)
      .and.to.emit(metisToken, "Transfer")
      .withArgs(admin.address, await lockingInfo.getAddress(), rewards);

    const balance2 = await metisToken.balanceOf(await lockingInfo.getAddress());
    expect(balance2 - balance1, "token increased").to.be.eq(rewards);

    // check new batch state
    {
      const { id, endEpoch, startEpoch, number } =
        await lockingPool.curBatchState();

      expect(id, "newBatchId").eq(newBatchId);
      expect(startEpoch, "newStartEpoch").eq(newStartEpoch);
      expect(endEpoch, "endEpoch").eq(newEndEpoch);
      expect(number, "blockNumber").eq(blockNumber + 1);
    }
  });

  it("withdrawReward", async () => {
    const {
      lockingInfo,
      lockingPool,
      mpc,
      wallets,
      admin,
      metisToken,
      l1Bridge,
    } = await loadFixture(fixture);

    const minLock = 1n;
    await lockingInfo.setMinLock(minLock);
    await lockingPool.updateMpc(mpc);

    await lockingInfo.setRewardPayer(admin);
    await metisToken.approve(await lockingInfo.getAddress(), ethers.MaxUint256);

    const [wallet0, wallet1] = wallets;

    await expect(lockingPool.withdrawRewards(1, 0)).to.revertedWithCustomError(
      lockingPool,
      "NotWhitelisted",
    );
    await expect(
      lockingPool.connect(wallet0).withdrawRewards(1, 0),
    ).to.revertedWithCustomError(lockingPool, "SeqNotActive");

    // seq1
    await lockingPool
      .connect(wallet0)
      .lockFor(
        wallet0,
        minLock,
        trimPubKeyPrefix(wallet0.signingKey.publicKey),
      );

    await expect(
      lockingPool.connect(wallet0).withdrawRewards(1, 0),
    ).to.revertedWithCustomError(lockingPool, "NoRewardRecipient");

    // set wallet1 as receipent
    await lockingPool.connect(wallet0).setSequencerRewardRecipient(1, wallet1);

    const [{ id: curBatchId, endEpoch: lastEndEpoch }, rpb, tatalLiquidated] =
      await Promise.all([
        lockingPool.curBatchState(),
        lockingPool.BLOCK_REWARD(),
        lockingInfo.totalRewardsLiquidated(),
      ]);

    const blocks = 2n;

    // distribute reward
    await lockingPool
      .connect(mpc)
      .batchSubmitRewards(
        curBatchId + 1n,
        lastEndEpoch + 1n,
        lastEndEpoch + 2n,
        [wallet0],
        [blocks],
      );
    const reward = blocks * rpb;

    await expect(lockingPool.connect(wallet0).withdrawRewards(1, 0))
      .to.emit(lockingInfo, "ClaimRewards")
      .withArgs(1, wallet1.address, reward, tatalLiquidated + reward)
      .and.emit(metisToken, "Approval")
      .withArgs(
        await lockingInfo.getAddress(),
        await l1Bridge.getAddress(),
        reward,
      )
      .and.emit(metisToken, "Transfer")
      .withArgs(
        await lockingInfo.getAddress(),
        await l1Bridge.getAddress(),
        reward,
      );

    expect(await lockingInfo.totalRewardsLiquidated()).eq(
      tatalLiquidated + reward,
    );

    const { reward: unclaimed } = await lockingPool.sequencers(1);
    expect(unclaimed, "unclaimed").to.eq(0);
  });
});
