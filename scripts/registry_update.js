const {
    ethers,
    upgrades
} = require("hardhat");
const web3 = require("web3");

let govProxyAddress = "0x937aaFF6b2aDdD3593CaE0d135530f4EDD6e4b65";
let registryAddress = "0x9Ebe9b50C08617158267654F893f8859991fd806";
let validatorShareFactoryAddress = "0x40B09Cc3242076412837208A41503Fd4c51554C6";
let stakingInfoAddress = "0x934b77c79bCD81510de51e61da58bE29Bce91497";
let stakingNftAddress = "0x5DB6a3111ea98AE461A4097C71CED4c9ef415526";
let metisTokenAddress = "0xD331E3CA3e51d3dd6712541CB01d7100E24DAdD1";
let testTokenAddress = "0x384d2a29acBf54F375939D0Ea6FD85969a628D74";
let stakeManagerProxyAddress = "0xC3f4dD007F97197151711556110f48d4c772D734";
let stakeManagerExtensionAddress = "0x81955bcCA0f852C072c877D1CCA1eD1b14c0E5eB";
let slashingManagerAddress = "0x2B3a174C812f550B58CAD89A23345d3867e99367";
let eventHubProxyAddress = "0xF7Ee63689b05B062Ebd15327CD80Cf81cC133fd0";

const main = async () => {
    // let stakeManagerHash = web3.utils.keccak256('stakeManager');
    // console.log("stakeManagerHash: ", stakeManagerHash)

    const govProxy = await hre.ethers.getContractFactory("Governance");
    const govProxyObj = await govProxy.attach(govProxyAddress);
    // let tx =  await updateContractMap(
    //         govProxyObj,
    //         registryAddress,
    //          web3.utils.keccak256('stakeManager'),
    //         stakeManagerProxyAddress
    //     )
    // console.log("updateContractMap tx:", tx.hash)
        
    // let tx = await updateContractMap(
    //     govProxyObj,
    //     registryAddress,
    //     web3.utils.keccak256('slashingManager'),
    //     slashingManagerAddress
    // )
    // console.log("updateContractMap tx:", tx.hash)

    //  let tx = await updateContractMap(
    //      govProxyObj,
    //      registryAddress,
    //      web3.utils.keccak256('eventsHub'),
    //      eventHubProxyAddress
    //  )
    //  console.log("updateContractMap tx:", tx.hash)

     let tx = await updateContractMap(
         govProxyObj,
         registryAddress,
         web3.utils.keccak256('validatorShare'),
         validatorShareFactoryAddress
     )
     console.log("updateContractMap tx:", tx.hash)
}

async function updateContractMap(govObj, registryAddress, key, value) {
     let ABI = [
         "function updateContractMap(bytes32 _key, address _address)"
     ];
     let iface = new ethers.utils.Interface(ABI);
     let encodeData = iface.encodeFunctionData("updateContractMap", [
         key,
         value,
     ])
     console.log("encodeData: ", encodeData)

    return govObj.update(
        registryAddress,
        encodeData
    )
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
