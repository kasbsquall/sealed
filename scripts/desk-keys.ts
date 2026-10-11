import fs from "fs";
import { randomInt } from "crypto";
import { Wallet } from "ethers";

/**
 * Creates .desk.env with a fresh operator key, seller key and a private seller
 * floor, readable by this user only. Prints addresses, never keys. Refuses to
 * overwrite an existing file.
 *
 *   npx tsx scripts/desk-keys.ts
 */
const file = process.env.DESK_ENV ?? ".desk.env";
if (fs.existsSync(file)) {
  console.error(`${file} already exists; not overwriting it`);
  process.exit(1);
}
const operator = Wallet.createRandom();
const seller = Wallet.createRandom();
// Somewhere between the demo seller's floor and the list price, unknown to anyone but this file.
const floor = 4000 + randomInt(0, 101);
fs.writeFileSync(
  file,
  [`DESK_OPERATOR_KEY=${operator.privateKey}`, `DESK_SELLER_KEY=${seller.privateKey}`, `DESK_SELLER_FLOOR=${floor}`, ""].join("\n"),
  { mode: 0o600 },
);
console.log(`wrote ${file}`);
console.log(`operator ${operator.address}  (fund this one with test MON)`);
console.log(`seller   ${seller.address}  (signs only, needs no MON)`);
