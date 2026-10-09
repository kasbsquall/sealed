import { ethers } from "hardhat";
import { chainFees } from "../agents/sealed/fees";

/** Fees for scripts that run through Hardhat's provider. See agents/sealed/fees.ts. */
export const fees = () => chainFees(ethers.provider);
