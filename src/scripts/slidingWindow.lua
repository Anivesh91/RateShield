-- SmartRate v3 — Atomic Sliding Window Rate Limiting Script (Sorted Sets)
-- KEYS[1] : Unique rate limit key (e.g. smartrate:sliding-window:POST:/api/login:127.0.0.1)
-- ARGV[1] : Current timestamp in milliseconds (now)
-- ARGV[2] : Window duration in milliseconds (windowMs)
-- ARGV[3] : Maximum allowed requests in window (limit)
-- ARGV[4] : Unique request member identifier (e.g. "1727181000000:uuid")

local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

local cutoff = now - windowMs

-- 1. Remove expired timestamps outside the rolling interval (now - windowMs, now]
redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

-- 2. Count active requests within the rolling window
local currentCount = redis.call("ZCARD", key)
local allowed = 0

if currentCount < limit then
    -- 3. Admitted: Add request with unique member and score = now
    redis.call("ZADD", key, now, member)
    currentCount = currentCount + 1
    allowed = 1
end

-- 4. Retrieve score of the oldest active request in the window for dynamic reset calculation
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local oldestScore = (oldest and #oldest >= 2) and tonumber(oldest[2]) or now

-- 5. Refresh TTL for stale-state cleanup (ensures key persists until newest request ages out)
redis.call("PEXPIRE", key, windowMs)

-- Return: [ allowed (1 or 0), currentCount, oldestScore ]
return { allowed, currentCount, oldestScore }
