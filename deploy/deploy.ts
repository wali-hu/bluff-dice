import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/** Seconds the player on turn has to act before anyone can claim the timeout (5 minutes). */
const DEFAULT_BID_TIMEOUT = 300;

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  // Chip token first: the game takes its address in the constructor (token-agnostic IERC7984).
  const chips = await deploy("BluffChips", {
    from: deployer,
    args: [deployer],
    log: true,
  });

  const game = await deploy("BluffDice", {
    from: deployer,
    args: [chips.address, DEFAULT_BID_TIMEOUT],
    log: true,
  });

  console.log(`BluffChips contract: `, chips.address);
  console.log(`BluffDice contract: `, game.address);
};
export default func;
func.id = "deploy_bluffDice"; // id required to prevent reexecution
func.tags = ["BluffDice", "BluffChips"];
