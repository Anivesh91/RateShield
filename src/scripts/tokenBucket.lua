-- SmartRate v5 — Atomic Token Bucket Rate Limiting Script (Redis Hash)
-- KEYS[1] : Unique rate limit key (e.g. smartrate:token-bucket:GET:/api/data:user_123)
-- ARGV[1] : Current timestamp in milliseconds (now)
-- ARGV[2] : Maximum bucket capacity (capacity)
-- ARGV[3] : Refill rate (refillRate)
-- ARGV[4] : Refill interval duration in milliseconds (refillIntervalMs)
-- ARGV[5] : Request cost in tokens (cost)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local refillIntervalMs = tonumber(ARGV[4]) or 1000
local cost = tonumber(ARGV[5]) or 1

-- Guard against zero or negative refillIntervalMs
if refillIntervalMs <= 0 then
    refillIntervalMs = 1000
end

local refillPerMs = refillRate / refillIntervalMs

-- 1. Read existing bucket state atomically from Redis Hash
local data = redis.call("HMGET", key, "tokens", "lastRefill")
local rawTokens = data[1]
local rawLastRefill = data[2]

local currentTokens = capacity
local lastRefill = now

if rawTokens and rawLastRefill then
    local prevTokens = tonumber(rawTokens)
    local prevLastRefill = tonumber(rawLastRefill)

    -- Continuous refill calculation based on elapsed milliseconds
    local elapsedMs = math.max(0, now - prevLastRefill)
    local tokensToAdd = elapsedMs * refillPerMs
    currentTokens = math.min(capacity, prevTokens + tokensToAdd)
    lastRefill = now
end

local allowed = 0
local remaining = 0
local retryAfter = 0

-- 2. Check token availability and consume tokens if sufficient
if currentTokens >= cost then
    currentTokens = currentTokens - cost
    allowed = 1
    remaining = math.floor(currentTokens)
    lastRefill = now
else
    allowed = 0
    remaining = math.floor(currentTokens)
    local neededTokens = cost - currentTokens
    local waitMs = neededTokens / refillPerMs
    retryAfter = math.max(1, math.ceil(waitMs / 1000))
end

-- 3. Update bucket state in Redis
redis.call("HSET", key, "tokens", tostring(currentTokens), "lastRefill", tostring(lastRefill))

-- 4. Set TTL so inactive buckets automatically expire from Redis
-- TTL is twice the time it takes to refill an empty bucket to full, with a minimum of 60 seconds
local fullTimeMs = math.ceil(capacity / refillPerMs)
local fullTimeSec = math.ceil(fullTimeMs / 1000)
local ttlSeconds = math.max(60, fullTimeSec * 2)
redis.call("EXPIRE", key, ttlSeconds)

-- 5. Calculate reset (Option C semantics):
-- For Token Bucket, RateLimit-Reset does not represent a fixed-window boundary.
-- On allowed responses it indicates time to full bucket restoration;
-- On blocked responses it indicates the next request-eligibility point (matching retryAfter).
local reset
if allowed == 1 then
    local timeToFullMs = math.max(0, (capacity - currentTokens) / refillPerMs)
    reset = math.max(1, math.ceil(timeToFullMs / 1000))
else
    reset = retryAfter
end

-- Return: [ allowed (1 or 0), remaining, reset, retryAfter ]
return { allowed, remaining, reset, retryAfter }
