import Redis from "ioredis";
import { config } from "../config.js";

let client: Redis | null = null;
const redis = () => (client ??= new Redis(config.redisUrl));

/** Keep `fn`'s JSON answer in Redis for `ttlSeconds` under `key`. The process keeps nothing in memory. */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const hit = await redis().get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await fn();
  await redis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}
