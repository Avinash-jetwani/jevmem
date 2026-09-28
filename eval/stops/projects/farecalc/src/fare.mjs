// Fares in euros. Base fare per zone, with a discount for concession riders.
export const ZONE_PRICE = 2.1;
export const DISCOUNTS = { adult: 0, concession: 0.4 };

export function fare(zones, rider = "adult") {
  if (!Number.isInteger(zones) || zones < 1) throw new Error("zones must be a positive integer");
  const discount = DISCOUNTS[rider];
  if (discount === undefined) throw new Error(`unknown rider type: ${rider}`);
  return zones * ZONE_PRICE * (1 - discount);
}
