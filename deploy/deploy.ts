import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/** Seconds the player on turn has to act before anyone can claim the timeout (5 minutes). */
const DEFAULT_BID_TIMEOUT = 300;

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const deployed = await deploy("BluffDice", {
    from: deployer,
    args: [DEFAULT_BID_TIMEOUT],
    log: true,
  });

  console.log(`BluffDice contract: `, deployed.address);
};
export default func;
func.id = "deploy_bluffDice"; // id required to prevent reexecution
func.tags = ["BluffDice"];
