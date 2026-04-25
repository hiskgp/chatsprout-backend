import Redis from 'ioredis';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

// Redis client singleton
let redisClient: Redis | null = null;

/**
 * Get Redis Client
 * Singleton pattern - reuse connection
 */
// export const getRedisClient = (): Redis => {
//   if (!redisClient) {
//     redisClient = new Redis({
//       host: process.env.REDIS_HOST || 'localhost',
//       port: parseInt(process.env.REDIS_PORT || '6379'),
//       password: process.env.REDIS_PASSWORD || undefined,
//       maxRetriesPerRequest: 3,
//       retryStrategy: (times: number) => {
//         const delay = Math.min(times * 50, 2000);
//         return delay;
//       },
//       lazyConnect: true,
//     });

//     redisClient.on('connect', () => {
//       logger.info('✅ Redis client connected');
//     });

//     redisClient.on('error', (err) => {
//       logger.error('❌ Redis client error:', err);
//     });
//   }

//   return redisClient;
// };

// Queue names

export const getRedisClient = (): Redis => {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null, // ✅ BullMQ requires null
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
      enableReadyCheck: false, // ✅ Prevents blocking
    });

    redisClient.on('connect', () => {
      logger.info('✅ Redis client connected');
    });

    redisClient.on('error', (err) => {
      logger.error('❌ Redis client error:', err);
    });

    redisClient.on('close', () => {
      logger.warn('⚠️ Redis connection closed');
    });

    redisClient.on('reconnecting', () => {
      logger.info('🔄 Redis reconnecting...');
    });
  }
  return redisClient;
};

export const QUEUE_NAMES = {
  WHATSAPP_SEND: 'whatsapp-send',
  WHATSAPP_RECEIVE: 'whatsapp-receive',
  AI_PROCESS: 'ai-process',
  CAMPAIGN_SEND: 'campaign-send',
  WEBHOOK_DELIVERY: 'webhook-delivery',
  VOICE_CALL: 'voice-call',
  ANALYTICS: 'analytics-process',
} as const;

// Queue instances
const queues: Map<string, Queue> = new Map();

/**
 * Get or create BullMQ Queue
 */
export const getQueue = (name: string): Queue => {
  if (!queues.has(name)) {
    const queue = new Queue(name, {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 1000, // Keep max 1000 completed jobs
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours
        },
      },
    });

    // Create scheduler for delayed jobs and retries
    new QueueScheduler(name, { connection: getRedisClient() });

    queues.set(name, queue);
    logger.info(`Queue created: ${name}`);
  }

  return queues.get(name)!;
};

/**
 * Cache Service
 * Simple key-value caching with TTL
 */
export const cache = {
  /**
   * Set cache with TTL
   */
  set: async (key: string, value: any, ttlSeconds: number = 3600): Promise<void> => {
    const client = getRedisClient();
    const serialized = JSON.stringify(value);
    await client.setex(key, ttlSeconds, serialized);
  },

  /**
   * Get cache
   */
  get: async <T>(key: string): Promise<T | null> => {
    const client = getRedisClient();
    const value = await client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  },

  /**
   * Delete cache
   */
  del: async (key: string): Promise<void> => {
    const client = getRedisClient();
    await client.del(key);
  },

  /**
   * Delete cache by pattern
   */
  delPattern: async (pattern: string): Promise<void> => {
    const client = getRedisClient();
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  },

  /**
   * Check if key exists
   */
  exists: async (key: string): Promise<boolean> => {
    const client = getRedisClient();
    const result = await client.exists(key);
    return result === 1;
  },

  /**
   * Increment counter
   */
  incr: async (key: string, ttlSeconds?: number): Promise<number> => {
    const client = getRedisClient();
    const value = await client.incr(key);
    if (ttlSeconds && value === 1) {
      await client.expire(key, ttlSeconds);
    }
    return value;
  },

  /**
   * Set with expiration if not exists
   */
  setNX: async (key: string, value: any, ttlSeconds: number): Promise<boolean> => {
    const client = getRedisClient();
    const serialized = JSON.stringify(value);
    const result = await client.set(key, serialized, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  },
};

/**
 * Session Service
 * Store user sessions in Redis
 */
export const session = {
  /**
   * Create session
   */
  create: async (sessionId: string, data: any, ttlSeconds: number = 86400): Promise<void> => {
    await cache.set(`session:${sessionId}`, data, ttlSeconds);
  },

  /**
   * Get session
   */
  get: async <T>(sessionId: string): Promise<T | null> => {
    return await cache.get<T>(`session:${sessionId}`);
  },

  /**
   * Update session
   */
  update: async (sessionId: string, data: any, ttlSeconds: number = 86400): Promise<void> => {
    await cache.set(`session:${sessionId}`, data, ttlSeconds);
  },

  /**
   * Delete session
   */
  destroy: async (sessionId: string): Promise<void> => {
    await cache.del(`session:${sessionId}`);
  },

  /**
   * Extend session TTL
   */
  touch: async (sessionId: string, ttlSeconds: number = 86400): Promise<void> => {
    const client = getRedisClient();
    await client.expire(`session:${sessionId}`, ttlSeconds);
  },
};

/**
 * Rate Limiter
 * Sliding window rate limiter using Redis
 */
export const rateLimiter = {
  /**
   * Check rate limit
   * Returns true if allowed, false if exceeded
   */
  check: async (
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> => {
    const client = getRedisClient();
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    // Remove old entries
    await client.zremrangebyscore(key, '-inf', windowStart);

    // Count current entries
    const count = await client.zcard(key);

    if (count >= limit) {
      const oldest = await client.zrange(key, 0, 0, 'WITHSCORES');
      const resetAt = oldest.length > 1? parseInt(oldest[1]) + windowSeconds * 1000 : now + windowSeconds * 1000;
      return { allowed: false, remaining: 0, resetAt };
    }

    // Add current request
    await client.zadd(key, now, `${now}-${Math.random()}`);
    await client.expire(key, windowSeconds);

    return {
      allowed: true,
      remaining: limit - count - 1,
      resetAt: now + windowSeconds * 1000,
    };
  },

  /**
   * Reset rate limit for key
   */
  reset: async (key: string): Promise<void> => {
    await cache.del(key);
  },
};

/**
 * Lock Service
 * Distributed locks for critical sections
 */
export const lock = {
  /**
   * Acquire lock
   */
  acquire: async (key: string, ttlSeconds: number = 30): Promise<boolean> => {
    return await cache.setNX(`lock:${key}`, Date.now(), ttlSeconds);
  },

  /**
   * Release lock
   */
  release: async (key: string): Promise<void> => {
    await cache.del(`lock:${key}`);
  },

  /**
   * Execute with lock
   */
  withLock: async <T>(key: string, fn: () => Promise<T>, ttlSeconds: number = 30): Promise<T> => {
    const acquired = await lock.acquire(key, ttlSeconds);
    if (!acquired) {
      throw new AppError('Resource is locked', 423, true, 'LOCKED');
    }

    try {
      return await fn();
    } finally {
      await lock.release(key);
    }
  },
};

/**
 * Pub/Sub Service
 * Real-time messaging between services
 */
export const pubsub = {
  /**
   * Publish message to channel
   */
  publish: async (channel: string, message: any): Promise<void> => {
    const client = getRedisClient();
    await client.publish(channel, JSON.stringify(message));
  },

  /**
   * Subscribe to channel
   */
  subscribe: (channel: string, handler: (message: any) => void): void => {
    const client = getRedisClient().duplicate();
    client.subscribe(channel);
    client.on('message', (ch, message) => {
      if (ch === channel) {
        try {
          const parsed = JSON.parse(message);
          handler(parsed);
        } catch (error) {
          logger.error('PubSub message parse error:', error);
        }
      }
    });
  },
};

/**
 * Initialize all queues on startup
 */
export const initializeQueues = (): void => {
  Object.values(QUEUE_NAMES).forEach((name) => {
    getQueue(name);
  });
  logger.info('All queues initialized');
};

/**
 * Close Redis connection
 * Called on graceful shutdown
 */
export const closeRedis = async (): Promise<void> => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }

  // Close all queues
  for (const queue of queues.values()) {
    await queue.close();
  }
  queues.clear();
  logger.info('All queues closed');
};

export default getRedisClient;