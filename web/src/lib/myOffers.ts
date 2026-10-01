// Offers this browser created, remembered per wallet address. The wallet may
// pay maker legs to fresh receive addresses, so `GET /offers?maker=<address>`
// can miss some; we merge these in while they are still on the book.

import { parseOffer } from "./api";
import type { Offer } from "./types";

const key = (address: string) => `dex.myOffers.${address}`;

export function loadMyOffers(address: string): Offer[] {
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.flatMap((o) => {
      try {
        return [parseOffer(o)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function save(address: string, offers: Offer[]) {
  try {
    localStorage.setItem(key(address), JSON.stringify(offers.slice(-200)));
  } catch {
    /* storage unavailable */
  }
}

export function rememberOffer(address: string, offer: Offer): void {
  const list = loadMyOffers(address).filter((o) => o.tx !== offer.tx);
  save(address, [...list, offer]);
}

export function forgetOffer(address: string, tx: string): void {
  save(
    address,
    loadMyOffers(address).filter((o) => o.tx !== tx),
  );
}
