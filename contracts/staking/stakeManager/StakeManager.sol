pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {GovernanceLockable} from "../../common/mixin/GovernanceLockable.sol";
import {DelegateProxyForwarder} from "../../common/misc/DelegateProxyForwarder.sol";
import {Registry} from "../../common/Registry.sol";
import {IStakeManager} from "./IStakeManager.sol";
import {IValidatorShare} from "../validatorShare/IValidatorShare.sol";
import {StakingInfo} from "../StakingInfo.sol";
import {StakingNFT} from "./StakingNFT.sol";
import {ValidatorShareFactory} from "../validatorShare/ValidatorShareFactory.sol";
import {StakeManagerStorage} from "./StakeManagerStorage.sol";
import {StakeManagerStorageExtension} from "./StakeManagerStorageExtension.sol";
import {IGovernance} from "../../common/governance/IGovernance.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {StakeManagerExtension} from "./StakeManagerExtension.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract StakeManager is
    StakeManagerStorage,
    IStakeManager,
    DelegateProxyForwarder,
    StakeManagerStorageExtension
{
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    modifier onlyStaker(uint256 validatorId) {
        _assertStaker(validatorId);
        _;
    }

    function _assertStaker(uint256 validatorId) private view {
        require(NFTContract.ownerOf(validatorId) == msg.sender);
    }

    modifier onlyDelegation(uint256 validatorId) {
        _assertDelegation(validatorId);
        _;
    }

    function _assertDelegation(uint256 validatorId) private view {
        require(validators[validatorId].contractAddress == msg.sender, "Invalid contract address");
    }

    address public owner;

    modifier onlyOwner() {
    require(msg.sender == owner, "ONLY_OWNER");
    _;
    }

    function initialize(
        address _governance,
        address _registry,
        address _token,
        address _NFTContract,
        address _stakingLogger,
        address _validatorShareFactory,
        address _owner,
        address _mpc,
        address _extensionCode
    ) external initializer {
        require(isContract(_extensionCode), "impl incorrect"); 
        extensionCode = _extensionCode; 
        governance = IGovernance(_governance);  
        registry = _registry;  
        token = IERC20(_token);  
        NFTContract = StakingNFT(_NFTContract); 
        logger = StakingInfo(_stakingLogger); 
        validatorShareFactory = ValidatorShareFactory(_validatorShareFactory); 
        owner = _owner;
        mpcAddress = _mpc;

        WITHDRAWAL_DELAY = (2**13); // unit: epoch 提现延迟时间，默认超大数，会通过updateDynastyValue方法进行更新
        currentEpoch = 1;  // 默认从第1个epoch开始
        dynasty = 886; // unit: epoch 50 days  ？？这个参
        BLOCK_REWARD = 2 * (10**18); // update via governance
        minDeposit = (10**18); // in ERC20 token
        signerUpdateLimit = 100; 

        validatorThreshold = 100; //允许最大的验证节点数量
        NFTCounter = 1; // validator id
        proposerBonus = 10; // 10 % of total rewards, 发起slash用户的奖励分成
        delegationEnabled = true; // 是否开启delegate
    }


    /**
        Public View Methods
     */

    function getRegistry() override public view returns (address) {
        return registry;
    }

    /**
        @dev Owner of validator slot NFT
     */
    function ownerOf(uint256 tokenId) override public view returns (address) {
        return NFTContract.ownerOf(tokenId);
    }

    // 查询当前epoch
    function epoch() override public view returns (uint256) {
        return currentEpoch;
    }

    // 查询退出时间
    function withdrawalDelay() override public view returns (uint256) {
        return WITHDRAWAL_DELAY;
    }

    // 查询验证节点stake数量
    function validatorStake(uint256 validatorId) override public view returns (uint256) {
        return validators[validatorId].amount;
    }

    // 根据地址获取validator id
    function getValidatorId(address user)  public view returns (uint256) {
        return NFTContract.tokenOfOwnerByIndex(user, 0);
    }

    // 查询验证节点抵押数量
    function delegatedAmount(uint256 validatorId) override public view returns (uint256) {
        return validators[validatorId].delegatedAmount;
    }

    // 查询被代理抵押奖励数量
    function delegatorsReward(uint256 validatorId) override public view returns (uint256) {
        uint256 _delegatorsReward;
        if (validators[validatorId].deactivationEpoch == 0) {
            (, _delegatorsReward) = _evaluateValidatorAndDelegationReward(validatorId);
        }
        return validators[validatorId].delegatorsReward.add(_delegatorsReward).sub(INITIALIZED_AMOUNT);
    }

    // 查询某个验证节点的总奖励
    function validatorReward(uint256 validatorId) public view returns (uint256) {
        uint256 _validatorReward;
        if (validators[validatorId].deactivationEpoch == 0) {
            (_validatorReward, ) = _evaluateValidatorAndDelegationReward(validatorId);
        }
        return validators[validatorId].reward.add(_validatorReward).sub(INITIALIZED_AMOUNT);
    }

    // 查询当前验证节点数量
    function currentValidatorSetSize() public view returns (uint256) {
        return validatorState.stakerCount;
    }

    // 查询验证节点总抵押数量
    function currentValidatorSetTotalStake() public view returns (uint256) {
        return validatorState.amount;
    }

    // 查询某个验证节点的合约地址
    function getValidatorContract(uint256 validatorId) public view returns (address) {
        return validators[validatorId].contractAddress;
    }

    function isValidator(uint256 validatorId) public view returns (bool) {
        return
            _isValidator(
                validators[validatorId].status,
                validators[validatorId].amount,
                validators[validatorId].deactivationEpoch,
                currentEpoch
            );
    }

    /**
        Governance Methods
     */

    function setDelegationEnabled(bool enabled) public onlyGovernance {
        delegationEnabled = enabled;
    }

    // Housekeeping function. @todo remove later
    function forceUnstake(uint256 validatorId) external onlyGovernance {
        _unstake(validatorId, currentEpoch);
    }

    function setCurrentEpoch(uint256 _currentEpoch) external onlyGovernance {
        currentEpoch = _currentEpoch;
    }

    // 设置staking代币
    function setStakingToken(address _token) public onlyGovernance {
        require(_token != address(0x0));
        token = IERC20(_token);
    }

    // 设置允许的最大验证节点数量
    function updateValidatorThreshold(uint256 newThreshold) public onlyGovernance {
        require(newThreshold != 0);
        logger.logThresholdChange(newThreshold, validatorThreshold);
        validatorThreshold = newThreshold;
    }

    // 设置batch提交区块奖励
    function updateBlockReward(uint256 newReward) public onlyGovernance {
        require(newReward != 0);
        logger.logRewardUpdate(newReward, BLOCK_REWARD);
        BLOCK_REWARD = newReward;
    }

    function insertSigners(address[] memory _signers) public onlyOwner {
        signers = _signers;
    }

    /**
        @dev Users must exit before this update or all funds may get lost
     */
    function updateValidatorContractAddress(uint256 validatorId, address newContractAddress) public onlyGovernance {
        require(IValidatorShare(newContractAddress).owner() == address(this));
        validators[validatorId].contractAddress = newContractAddress;
    }

    function updateDynastyValue(uint256 newDynasty) public onlyGovernance {
        require(newDynasty > 0);
        logger.logDynastyValueChange(newDynasty, dynasty);
        dynasty = newDynasty;
        WITHDRAWAL_DELAY = newDynasty;
    }

    function updateProposerBonus(uint256 newProposerBonus) public onlyGovernance {
        logger.logProposerBonusChange(newProposerBonus, proposerBonus);
        require(newProposerBonus <= MAX_PROPOSER_BONUS, "too big");
        proposerBonus = newProposerBonus;
    }

    function updateSignerUpdateLimit(uint256 _limit) public onlyGovernance {
        signerUpdateLimit = _limit;
    }

    function updateMinAmounts(uint256 _minDeposit) public onlyGovernance {
        minDeposit = _minDeposit;
    }

    function drainValidatorShares(
        uint256 validatorId,
        address tokenAddr,
        address payable destination,
        uint256 amount
    ) external onlyGovernance {
        address contractAddr = validators[validatorId].contractAddress;
        require(contractAddr != address(0x0));
        IValidatorShare(contractAddr).drain(tokenAddr, destination, amount);
    }

    // 提出指定数量的代币
    function drain(address destination, uint256 amount) external onlyGovernance {
        _transferToken(destination, amount);
    }

    function setMpc(address _newMpc) external onlyGovernance {
        require(!isContract(_newMpc),"_newMpc is a contract");
        require(_newMpc != address(0x0),"_newMpc is zero address");
        mpcAddress = _newMpc;
    }

    function reinitialize(
        address _NFTContract,
        address _stakingLogger,
        address _validatorShareFactory,
        address _extensionCode
    ) external onlyGovernance {
        require(isContract(_extensionCode));
        eventsHub = address(0x0);
        extensionCode = _extensionCode;
        NFTContract = StakingNFT(_NFTContract);
        logger = StakingInfo(_stakingLogger);
        validatorShareFactory = ValidatorShareFactory(_validatorShareFactory);
    }

    /**
        Public Methods
     */
    // 查询某个验证节点地址总的抵押金额
    function totalStakedFor(address user) override external view returns (uint256) {
        if (user == address(0x0) || NFTContract.balanceOf(user) == 0) {
            return 0;
        }
        return validators[NFTContract.tokenOfOwnerByIndex(user, 0)].amount;
    }

    // 某个验证节点退出
    function unstake(uint256 validatorId) override external onlyStaker(validatorId) {
        Status status = validators[validatorId].status;
        require(
            validators[validatorId].activationEpoch > 0 &&
                validators[validatorId].deactivationEpoch == 0 &&
                (status == Status.Active || status == Status.Locked)
        );

        uint256 exitEpoch = currentEpoch.add(1); // notice period
        _unstake(validatorId, exitEpoch);
    }

    function transferFunds(
        uint256 validatorId,
        uint256 amount,
        address delegator
    ) override external returns (bool) {
        require(
            // validators[validatorId].contractAddress == msg.sender ||
            validators[validatorId].contractAddress == msg.sender,
                // Registry(registry).getSlashingManagerAddress() == msg.sender,
            "not allowed"
        );
        return token.transfer(delegator, amount);
    }

    function delegationDeposit(
        uint256 validatorId,
        uint256 amount,
        address delegator
    ) override external onlyDelegation(validatorId) returns (bool) {
        return token.transferFrom(delegator, address(this), amount);
    }

    function stakeFor(
        address user,
        uint256 amount,
        bool acceptDelegation,
        bytes memory signerPubkey
    ) override public  onlyWhenUnlocked {
        require(currentValidatorSetSize() < validatorThreshold, "no more slots");
        require(amount >= minDeposit, "not enough deposit");
        _transferTokenFrom(msg.sender, address(this), amount);
        _stakeFor(user, amount, acceptDelegation, signerPubkey);
    }

    function unstakeClaim(uint256 validatorId) public onlyStaker(validatorId) {
        uint256 deactivationEpoch = validators[validatorId].deactivationEpoch;
        // can only claim stake back after WITHDRAWAL_DELAY
        require(
            deactivationEpoch > 0 &&
                deactivationEpoch.add(WITHDRAWAL_DELAY) <= currentEpoch &&
                validators[validatorId].status != Status.Unstaked
        );

        uint256 amount = validators[validatorId].amount;
        uint256 newTotalStaked = totalStaked.sub(amount);
        totalStaked = newTotalStaked;

        // claim last checkpoint reward if it was signed by validator
        _liquidateRewards(validatorId, msg.sender);

        NFTContract.burn(validatorId);

        validators[validatorId].amount = 0;
        validators[validatorId].signer = address(0);

        signerToValidator[validators[validatorId].signer] = INCORRECT_VALIDATOR_ID;
        validators[validatorId].status = Status.Unstaked;

        _transferToken(msg.sender, amount);
        logger.logUnstaked(msg.sender, validatorId, amount, newTotalStaked);
    }

    function restake(
        uint256 validatorId,
        uint256 amount,
        bool stakeRewards
    ) public onlyWhenUnlocked onlyStaker(validatorId) {
        require(validators[validatorId].deactivationEpoch == 0, "No restaking");

        if (amount > 0) {
            _transferTokenFrom(msg.sender, address(this), amount);
        }

        _updateRewards(validatorId);

        if (stakeRewards) {
            amount = amount.add(validators[validatorId].reward).sub(INITIALIZED_AMOUNT);
            validators[validatorId].reward = INITIALIZED_AMOUNT;
        }

        uint256 newTotalStaked = totalStaked.add(amount);
        totalStaked = newTotalStaked;
        validators[validatorId].amount = validators[validatorId].amount.add(amount);

        updateTimeline(int256(amount), 0, 0);

        logger.logStakeUpdate(validatorId);
        logger.logRestaked(validatorId, validators[validatorId].amount, newTotalStaked);
    }

    function withdrawRewards(uint256 validatorId) public onlyStaker(validatorId) {
        _updateRewards(validatorId);
        _liquidateRewards(validatorId, msg.sender);
    }

    function migrateDelegation(
        uint256 fromValidatorId,
        uint256 toValidatorId,
        uint256 amount
    ) public {
        // allow to move to any non-foundation node
        require(toValidatorId > 7, "Invalid migration");
        IValidatorShare(validators[fromValidatorId].contractAddress).migrateOut(msg.sender, amount);
        IValidatorShare(validators[toValidatorId].contractAddress).migrateIn(msg.sender, amount);
    }

    function updateValidatorState(uint256 validatorId, int256 amount) override public onlyDelegation(validatorId) {
        if (amount > 0) {
            // deposit during shares purchase
            require(delegationEnabled, "Delegation is disabled");
        }

        uint256 deactivationEpoch = validators[validatorId].deactivationEpoch;

        if (deactivationEpoch == 0) { // modify timeline only if validator didn't unstake
            updateTimeline(amount, 0, 0);
        } else if (deactivationEpoch > currentEpoch) { // validator just unstaked, need to wait till next checkpoint
            revert("unstaking");
        }
        

        if (amount >= 0) {
            increaseValidatorDelegatedAmount(validatorId, uint256(amount));
        } else {
            decreaseValidatorDelegatedAmount(validatorId, uint256(amount * -1));
        }
    }

    function increaseValidatorDelegatedAmount(uint256 validatorId, uint256 amount) private {
        validators[validatorId].delegatedAmount = validators[validatorId].delegatedAmount.add(amount);
    }

    function decreaseValidatorDelegatedAmount(uint256 validatorId, uint256 amount) override public onlyDelegation(validatorId) {
        validators[validatorId].delegatedAmount = validators[validatorId].delegatedAmount.sub(amount);
    }

    function updateSigner(uint256 validatorId, bytes memory signerPubkey) public onlyStaker(validatorId) {
        address signer = _getAndAssertSigner(signerPubkey);
        uint256 _currentEpoch = currentEpoch;
        require(_currentEpoch >= latestSignerUpdateEpoch[validatorId].add(signerUpdateLimit), "Not allowed");

        address currentSigner = validators[validatorId].signer;
        // update signer event
        logger.logSignerChange(validatorId, currentSigner, signer, signerPubkey);
        
        if (validators[validatorId].deactivationEpoch == 0) { 
            // didn't unstake, swap signer in the list
            _removeSigner(currentSigner);
            _insertSigner(signer);
        }

        signerToValidator[currentSigner] = INCORRECT_VALIDATOR_ID;
        signerToValidator[signer] = validatorId;
        validators[validatorId].signer = signer;

        // reset update time to current time
        latestSignerUpdateEpoch[validatorId] = _currentEpoch;
    }

// submit every epoch
    function batchSubmitRewards(
        address payeer,
        address[] memory validators,
        uint256[] memory rewards
        // uint256[] memory finishedBlocks
        // bytes memory signature
    // )  external onlyGovernance  returns (uint256) {
    )  public returns (uint256) {
        // check mpc signature
        // bytes32 operationHash = keccak256(abi.encodePacked(fromEpoch,endEpoch,validators,finishedBlocks, address(this)));
        // operationHash = ECDSA.toEthSignedMessageHash(operationHash);
        // address signer = ECDSA.recover(operationHash, signature);
        // require(signer == mpcAddress, "invalid mpc signature");
        // require(signer == address(0xB4ebe166513C578e33A8373f04339508bC7E8Cfb),"invalid signer");

        // calc reward
        uint256 totalReward;
        for (uint256 i = 0; i < validators.length; ++i) {
            _increaseReward(validators[i],rewards[i]);
            totalReward += rewards[i];
        }

        // reward income
        token.safeTransferFrom(payeer, address(this), totalReward);
        return totalReward;
    }

    function updateCommissionRate(uint256 validatorId, uint256 newCommissionRate) external onlyStaker(validatorId) {
        _updateRewards(validatorId);

        delegatedFwd(
            extensionCode,
            abi.encodeWithSelector(
                StakeManagerExtension(extensionCode).updateCommissionRate.selector,
                validatorId,
                newCommissionRate
            )
        );
    }

    function withdrawDelegatorsReward(uint256 validatorId) override public onlyDelegation(validatorId) returns (uint256) {
        _updateRewards(validatorId);

        uint256 totalReward = validators[validatorId].delegatorsReward.sub(INITIALIZED_AMOUNT);
        validators[validatorId].delegatorsReward = INITIALIZED_AMOUNT;
        return totalReward;
    }

    function updateTimeline(
        int256 amount,
        int256 stakerCount,
        uint256 targetEpoch
    ) internal {
        if (targetEpoch == 0) {
            // update total stake and validator count
            if (amount > 0) {
                validatorState.amount = validatorState.amount.add(uint256(amount));
            } else if (amount < 0) {
                validatorState.amount = validatorState.amount.sub(uint256(amount * -1));
            }

            if (stakerCount > 0) {
                validatorState.stakerCount = validatorState.stakerCount.add(uint256(stakerCount));
            } else if (stakerCount < 0) {
                validatorState.stakerCount = validatorState.stakerCount.sub(uint256(stakerCount * -1));
            }
        } else {
            validatorStateChanges[targetEpoch].amount += amount;
            validatorStateChanges[targetEpoch].stakerCount += stakerCount;
        }
    }

    function updateValidatorDelegation(bool delegation) external {
        uint256 validatorId = signerToValidator[msg.sender];
        require(
            _isValidator(
                validators[validatorId].status,
                validators[validatorId].amount,
                validators[validatorId].deactivationEpoch,
                currentEpoch
            ),
            "not validator"
        );

        address contractAddr = validators[validatorId].contractAddress;
        require(contractAddr != address(0x0), "Delegation is disabled");

        IValidatorShare(contractAddr).updateDelegation(delegation);
    }

    /**
        Private Methods
     */

    function _getAndAssertSigner(bytes memory pub) private view returns (address) {
        require(pub.length == 64, "not pub");
        address signer = address(uint160(uint256(keccak256(pub))));
        require(signer != address(0) && signerToValidator[signer] == 0, "Invalid signer");
        return signer;
    }

    function _isValidator(
        Status status,
        uint256 amount,
        uint256 deactivationEpoch,
        uint256 _currentEpoch
    ) private pure returns (bool) {
        return (amount > 0 && (deactivationEpoch == 0 || deactivationEpoch > _currentEpoch) && status == Status.Active);
    }

     function _calculateReward(
        uint256 blockInterval
    ) internal view returns (uint256) {
        // rewards are based on BlockInterval multiplied on `BLOCK_REWARD`
        return blockInterval.mul(BLOCK_REWARD);
    }

    function _increaseReward(
        address validator,
        // uint256 blockInterval
        uint256 reward
    ) private returns (uint256) {
        uint256 currentTotalStake = validatorState.amount;
        // uint256 reward = _calculateReward(blockInterval);

        // validator reward update
        uint256 validatorId = signerToValidator[validator];

        // rewardPerStake update
        uint256 newRewardPerStake = rewardPerStake.add(reward.mul(REWARD_PRECISION).div(currentTotalStake));
        _updateRewardsAndCommitWithFixedReward(validatorId, reward,newRewardPerStake);
        rewardPerStake = newRewardPerStake;
        
        _finalizeCommit();
        return reward;
    }

    function _updateRewardsAndCommitWithFixedReward(uint256 validatorId,uint256 reward, uint256 newRewardPerStake) private{
        uint256 deactivationEpoch = validators[validatorId].deactivationEpoch;
        if (deactivationEpoch != 0 && currentEpoch >= deactivationEpoch) {
            return;
        }

        uint256 initialRewardPerStake = validators[validatorId].initialRewardPerStake;

        uint256 validatorsStake = validators[validatorId].amount;
        uint256 _delegatedAmount = validators[validatorId].delegatedAmount;
        if (_delegatedAmount > 0) {
            _increaseValidatorRewardWithDelegation(
                validatorId,
                validatorsStake,
                _delegatedAmount,
                reward
            );
        } else {
            _increaseValidatorReward(
                validatorId,
                reward
            );
        }

        if (newRewardPerStake > initialRewardPerStake) {
            validators[validatorId].initialRewardPerStake = newRewardPerStake;
        }
    }

    function _updateRewardsAndCommit(
        uint256 validatorId,
        uint256 currentRewardPerStake,
        uint256 newRewardPerStake
    ) private {
        uint256 deactivationEpoch = validators[validatorId].deactivationEpoch;
        if (deactivationEpoch != 0 && currentEpoch >= deactivationEpoch) {
            return;
        }

        uint256 initialRewardPerStake = validators[validatorId].initialRewardPerStake;

        // attempt to save gas in case if rewards were updated previosuly
        if (initialRewardPerStake < currentRewardPerStake) {
            uint256 validatorsStake = validators[validatorId].amount;
            uint256 _delegatedAmount = validators[validatorId].delegatedAmount;
            if (_delegatedAmount > 0) {
                uint256 combinedStakePower = validatorsStake.add(_delegatedAmount);
                _increaseValidatorRewardWithDelegation(
                    validatorId,
                    validatorsStake,
                    _delegatedAmount,
                    _getEligibleValidatorReward(
                        validatorId,
                        combinedStakePower,
                        currentRewardPerStake,
                        initialRewardPerStake
                    )
                );
            } else {
                _increaseValidatorReward(
                    validatorId,
                    _getEligibleValidatorReward(
                        validatorId,
                        validatorsStake,
                        currentRewardPerStake,
                        initialRewardPerStake
                    )
                );
            }
        }

        if (newRewardPerStake > initialRewardPerStake) {
            validators[validatorId].initialRewardPerStake = newRewardPerStake;
        }
    }

    function _updateRewards(uint256 validatorId) private {
        _updateRewardsAndCommit(validatorId, rewardPerStake, rewardPerStake);
    }

    function _getEligibleValidatorReward(
        uint256 validatorId,
        uint256 validatorStakePower,
        uint256 currentRewardPerStake,
        uint256 initialRewardPerStake
    ) private pure returns (uint256) {
        uint256 eligibleReward = currentRewardPerStake - initialRewardPerStake;
        return eligibleReward.mul(validatorStakePower).div(REWARD_PRECISION);
    }

    function _increaseValidatorReward(uint256 validatorId, uint256 reward) private {
        if (reward > 0) {
            validators[validatorId].reward = validators[validatorId].reward.add(reward);
        }
    }

    function _increaseValidatorRewardWithDelegation(
        uint256 validatorId,
        uint256 validatorsStake,
        uint256 _delegatedAmount,
        uint256 reward
    ) private {
        uint256 combinedStakePower = _delegatedAmount.add(validatorsStake);
        (uint256 newValidatorReward, uint256 newDelegatorsReward) =
            _getValidatorAndDelegationReward(validatorId, validatorsStake, reward, combinedStakePower);

        if (newDelegatorsReward > 0) {
            validators[validatorId].delegatorsReward = validators[validatorId].delegatorsReward.add(newDelegatorsReward);
        }

        if (newValidatorReward > 0) {
            validators[validatorId].reward = validators[validatorId].reward.add(newValidatorReward);
        }
    }

    function _getValidatorAndDelegationReward(
        uint256 validatorId,
        uint256 validatorsStake,
        uint256 reward,
        uint256 combinedStakePower
    ) internal view returns (uint256, uint256) {
        if (combinedStakePower == 0) {
            return (0, 0);
        }

        uint256 newValidatorReward = validatorsStake.mul(reward).div(combinedStakePower);

        // add validator commission from delegation reward
        uint256 commissionRate = validators[validatorId].commission.commissionRate;
        if (commissionRate > 0) {
            newValidatorReward = newValidatorReward.add(
                reward.sub(newValidatorReward).mul(commissionRate).div(MAX_COMMISION_RATE)
            );
        }

        uint256 newDelegatorsReward = reward.sub(newValidatorReward);
        return (newValidatorReward, newDelegatorsReward);
    }

    function _evaluateValidatorAndDelegationReward(uint256 validatorId)
        private
        view
        returns (uint256 , uint256 )
    {
        uint256 validatorsStake = validators[validatorId].amount;
        uint256 combinedStakePower = validatorsStake.add(validators[validatorId].delegatedAmount);
        uint256 eligibleReward = rewardPerStake - validators[validatorId].initialRewardPerStake;
        return
            _getValidatorAndDelegationReward(
                validatorId,
                validatorsStake,
                eligibleReward.mul(combinedStakePower).div(REWARD_PRECISION),
                combinedStakePower
            );
    }

    function _stakeFor(
        address user,
        uint256 amount,
        bool acceptDelegation,
        bytes memory signerPubkey
    ) internal returns (uint256) {
        address signer = _getAndAssertSigner(signerPubkey);
        uint256 _currentEpoch = currentEpoch;
        uint256 validatorId = NFTCounter;
        StakingInfo _logger = logger;

        uint256 newTotalStaked = totalStaked.add(amount);
        totalStaked = newTotalStaked;

        validators[validatorId] = Validator({
            reward: INITIALIZED_AMOUNT,
            amount: amount,
            activationEpoch: _currentEpoch,
            deactivationEpoch: 0,
            signer: signer,
            contractAddress: acceptDelegation
                ? validatorShareFactory.create(validatorId, address(_logger), registry)
                : address(0x0),
            commission: Commission({
                commissionRate: 0,
                lastCommissionUpdate: 0
            }),
            status: Status.Active,
            delegatorsReward: INITIALIZED_AMOUNT,
            delegatedAmount: 0,
            initialRewardPerStake: rewardPerStake
        });

        latestSignerUpdateEpoch[validatorId] = _currentEpoch;
        NFTContract.mint(user, validatorId);

        signerToValidator[signer] = validatorId;
        updateTimeline(int256(amount), 1, 0);

        _logger.logStaked(signer, signerPubkey, validatorId, _currentEpoch, amount, newTotalStaked);
        NFTCounter = validatorId.add(1);

        _insertSigner(signer);

        return validatorId;
    }

    function _unstake(uint256 validatorId, uint256 exitEpoch) internal {
        // TODO: if validators unstake and slashed to 0, he will be forced to unstake again
        // must think how to handle it correctly
        _updateRewards(validatorId);

        uint256 amount = validators[validatorId].amount;
        address validator = ownerOf(validatorId);

        validators[validatorId].deactivationEpoch = exitEpoch;

        // unbond all delegators in future
        int256 delegationAmount = int256(validators[validatorId].delegatedAmount);

        address delegationContract = validators[validatorId].contractAddress;
        if (delegationContract != address(0)) {
            IValidatorShare(delegationContract).lock();
        }

        _removeSigner(validators[validatorId].signer);
        _liquidateRewards(validatorId, validator);

        uint256 targetEpoch = exitEpoch <= currentEpoch ? 0 : exitEpoch;
        updateTimeline(-(int256(amount) + delegationAmount), -1, targetEpoch);

        logger.logUnstakeInit(validator, validatorId, exitEpoch, amount);
    }

    function _finalizeCommit() internal {
        uint256 _currentEpoch = currentEpoch;
        uint256 nextEpoch = _currentEpoch.add(1);

        StateChange memory changes = validatorStateChanges[nextEpoch];
        updateTimeline(changes.amount, changes.stakerCount, 0);

        delete validatorStateChanges[_currentEpoch];

        currentEpoch = nextEpoch;
    }

    function _liquidateRewards(uint256 validatorId, address validatorUser) private {
        uint256 reward = validators[validatorId].reward.sub(INITIALIZED_AMOUNT);
        totalRewardsLiquidated = totalRewardsLiquidated.add(reward);
        validators[validatorId].reward = INITIALIZED_AMOUNT;
        _transferToken(validatorUser, reward);
        logger.logClaimRewards(validatorId, reward, totalRewardsLiquidated);
    }

    function _transferToken(address destination, uint256 amount) private {
        require(token.transfer(destination, amount), "transfer failed");
    }

    function _transferTokenFrom(
        address from,
        address destination,
        uint256 amount
    ) private {
        require(token.transferFrom(from, destination, amount), "transfer from failed");
    }

    function _insertSigner(address newSigner) internal {
        signers.push(newSigner);

        uint lastIndex = signers.length - 1;
        uint i = lastIndex;
        for (; i > 0; --i) {
            address signer = signers[i - 1];
            if (signer < newSigner) {
                break;
            }
            signers[i] = signer;
        }

        if (i != lastIndex) {
            signers[i] = newSigner;
        }
    }

    function _removeSigner(address signerToDelete) internal {
        uint256 totalSigners = signers.length;
        address swapSigner = signers[totalSigners - 1];
        delete signers[totalSigners - 1];

        // bubble last element to the beginning until target signer is met
        for (uint256 i = totalSigners - 1; i > 0; --i) {
            if (swapSigner == signerToDelete) {
                break;
            }

            (swapSigner, signers[i - 1]) = (signers[i - 1], swapSigner);
        }
    }
}
