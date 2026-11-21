import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * One-off probe of the dice cost on a real network.
 *
 *   npx hardhat --network sepolia task:d6-probe            # deploys D6Harness, rolls 20 dice once
 *   npx hardhat --network sepolia task:d6-probe --address 0x...   # reuse a deployed harness
 *
 * Prints the tx hash, gasUsed (vs the EIP-7825 per-tx cap) and the HCU computed from the
 * coprocessor events of the receipt. 20 dice = what a 4-player table rolls in its start transaction.
 */
const TX_GAS_CAP = 16_777_216n;

task("task:d6-probe", "Deploys D6Harness (unless --address) and rolls 20 dice once")
  .addOptionalParam("address", "Existing D6Harness address")
  .addOptionalParam("count", "Dice to roll", "20")
  .setAction(async function (args: TaskArguments, hre) {
    const { ethers, fhevm, network } = hre;
    await fhevm.initializeCLIApi();

    const [signer] = await ethers.getSigners();
    console.log(`network: ${network.name}  signer: ${signer.address}`);

    let address: string = args.address;
    if (!address) {
      const factory = await ethers.getContractFactory("D6Harness", signer);
      const harness = await factory.deploy();
      const deployTx = harness.deploymentTransaction();
      await harness.waitForDeployment();
      address = await harness.getAddress();
      console.log(`D6Harness deployed: ${address}  (tx ${deployTx?.hash})`);
    }

    const harness = await ethers.getContractAt("D6Harness", address, signer);
    const count = Number(args.count);
    const tx = await harness.rollMany(count, { gasLimit: TX_GAS_CAP });
    console.log(`rollMany(${count}) sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`rollMany failed: ${tx.hash}`);

    const { globalHCU, maxHCUDepth } = fhevm.computeTransactionHCU(receipt);
    const pct = Number((receipt.gasUsed * 10_000n) / TX_GAS_CAP) / 100;
    console.log(`block:     ${receipt.blockNumber}`);
    console.log(`gasUsed:   ${receipt.gasUsed}  (${pct.toFixed(2)}% of the ${TX_GAS_CAP} per-tx cap)`);
    console.log(`HCU:       ${globalHCU}  depth ${maxHCUDepth}  (computed from the receipt's coprocessor events)`);
  });
