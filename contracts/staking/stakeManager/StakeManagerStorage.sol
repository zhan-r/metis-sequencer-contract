pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Registry} from "../../common/Registry.sol";
import {GovernanceLockable} from "../../common/mixin/GovernanceLockable.sol";
import {StakingInfo} from "../StakingInfo.sol";
import {StakingNFT} from "./StakingNFT.sol";
import {ValidatorShareFactory} from "../validatorShare/ValidatorShareFactory.sol";

abstract contract StakeManagerStorage is GovernanceLockable {
    enum Status {Inactive, Active, Locked, Unstaked}

    struct State {
        uint256 amount;
        uint256 stakerCount;
    }

    struct StateChange {
        int256 amount;
        int256 stakerCount;
    }

    struct Commission {
        uint256 commissionRate;
        uint256 lastCommissionUpdate;
    }

    struct Validator {
        uint256 amount;
        uint256 reward;
        uint256 activationEpoch;
        uint256 deactivationEpoch;
        address signer;
        address contractAddress;
        Status status;
        Commission commission; 
        uint256 delegatorsReward;
        uint256 delegatedAmount;
        uint256 initialRewardPerStake;
    }

    uint256 constant MAX_COMMISION_RATE = 100;
    uint256 constant MAX_PROPOSER_BONUS = 100;
    uint256 constant REWARD_PRECISION = 10**25;
    uint256 internal constant INCORRECT_VALIDATOR_ID = 2**256 - 1;
    uint256 internal constant INITIALIZED_AMOUNT = 1;

    IERC20 public token;
    address public registry;
    StakingInfo public logger;
    StakingNFT public NFTContract;
    ValidatorShareFactory public validatorShareFactory;
    uint256 public WITHDRAWAL_DELAY; // unit: epoch, every epoch mins 8 hours
    uint256 public currentEpoch;

    // genesis/governance variables
    uint256 public dynasty; // unit: epoch
    uint256 public BLOCK_REWARD; // update via governance
    uint256 public minDeposit; // in ERC20 token
    uint256 public signerUpdateLimit;
    address public mpcAddress;

    uint256 public validatorThreshold; //128
    uint256 public totalStaked;
    uint256 public NFTCounter;
    uint256 public totalRewards;
    uint256 public totalRewardsLiquidated;
    uint256 public proposerBonus; // 10 % of total rewards
    bool public delegationEnabled;

    mapping(uint256 => Validator) public validators;
    mapping(address => uint256) public signerToValidator;

    // current epoch stake power and stakers count
    State public validatorState;
    mapping(uint256 => StateChange) public validatorStateChanges;

    // validatorId to last signer update epoch
    mapping(uint256 => uint256) public latestSignerUpdateEpoch;

    // mpc history
    struct MpcHistoryItem {
        uint256 startBlock;
        address newMpcAddress;
    }
    MpcHistoryItem[] public mpcHistory; // recent mpc
}
