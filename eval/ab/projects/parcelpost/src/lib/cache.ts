import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

/** Read `key` from Redis, or compute it with `fn` and store it for `ttlSeconds`. Keys are prefixed with `pp:`. */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  const hit = await redis.get(`pp:${key}`);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await fn();
  await redis.set(`pp:${key}`, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}
